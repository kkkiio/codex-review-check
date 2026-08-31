import * as github from "@actions/github";
import type {
  IssueCommentRecord,
  ReactionRecord,
  ReviewRecord,
  ReviewSnapshot,
  ReviewThreadRecord,
  ThreadCommentRecord,
} from "./types.js";

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            comments(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes { author { login } body createdAt url }
            }
          }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = `
  query ThreadComments($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { author { login } body createdAt url }
        }
      }
    }
  }
`;

interface GraphPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GraphComment {
  author: { login?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
  url?: string | null;
}

interface GraphThread {
  id?: string | null;
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  comments?: { pageInfo?: GraphPageInfo | null; nodes?: GraphComment[] | null } | null;
}

interface GraphThreadsConnection {
  pageInfo?: GraphPageInfo | null;
  nodes?: GraphThread[] | null;
}

interface GraphThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads?: GraphThreadsConnection | null;
    } | null;
  } | null;
}

interface GraphCommentsResponse {
  node?: {
    comments?: { pageInfo?: GraphPageInfo | null; nodes?: GraphComment[] | null } | null;
  } | null;
}

export async function loadReviewSnapshot(
  token: string,
  repository: string,
  pullRequest: number,
): Promise<ReviewSnapshot> {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }
  const octokit = github.getOctokit(token);
  const pull = await octokit.rest.pulls.get({ owner, repo, pull_number: pullRequest });
  if (pull.data.state !== "open") {
    throw new Error(`Pull request ${repository}#${pullRequest} is not open.`);
  }
  const headSha = pull.data.head.sha;
  const [commit, rawReviews, rawReactions, rawIssueComments] = await Promise.all([
    octokit.rest.repos.getCommit({ owner, repo, ref: headSha }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullRequest,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.reactions.listForIssue, {
      owner,
      repo,
      issue_number: pullRequest,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullRequest,
      per_page: 100,
    }),
  ]);

  const reviews: ReviewRecord[] = rawReviews.map((review) => ({
    author: review.user?.login ?? "",
    state: review.state ?? "",
    commitId: review.commit_id ?? "",
    submittedAt: review.submitted_at ?? null,
    url: review.html_url ?? null,
  }));
  const reactions: ReactionRecord[] = rawReactions.map((reaction) => ({
    author: reaction.user?.login ?? "",
    content: reaction.content ?? "",
    createdAt: reaction.created_at ?? null,
  }));
  const requestCommentReactions = new Map<number, ReactionRecord[]>();
  await Promise.all(
    rawIssueComments.map(async (comment) => {
      if (!/@codex[ \t]+review\b/iu.test(comment.body ?? "")) {
        return;
      }
      const commentReactions = await octokit.paginate(
        octokit.rest.reactions.listForIssueComment,
        {
          owner,
          repo,
          comment_id: comment.id,
          per_page: 100,
        },
      );
      requestCommentReactions.set(
        comment.id,
        commentReactions.map((reaction) => ({
          author: reaction.user?.login ?? "",
          content: reaction.content ?? "",
          createdAt: reaction.created_at ?? null,
        })),
      );
    }),
  );
  const issueComments: IssueCommentRecord[] = rawIssueComments.map((comment) => ({
    author: comment.user?.login ?? "",
    authorType: comment.user?.type ?? null,
    appSlug: comment.performed_via_github_app?.slug ?? null,
    body: comment.body ?? "",
    createdAt: comment.created_at ?? null,
    url: comment.html_url ?? null,
    reactions: requestCommentReactions.get(comment.id) ?? [],
  }));

  const threads: ReviewThreadRecord[] = [];
  let threadCursor: string | null = null;
  while (true) {
    const response: GraphThreadsResponse = await octokit.graphql<GraphThreadsResponse>(REVIEW_THREADS_QUERY, {
      owner,
      repo,
      number: pullRequest,
      after: threadCursor,
    });
    const connection: GraphThreadsConnection | null | undefined =
      response.repository?.pullRequest?.reviewThreads;
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) {
      throw new Error(`GitHub GraphQL did not return reviewThreads for ${repository}#${pullRequest}.`);
    }
    for (const thread of connection.nodes) {
      if (!thread.id || !thread.comments?.pageInfo || !Array.isArray(thread.comments.nodes)) {
        throw new Error("GitHub GraphQL returned an incomplete review thread.");
      }
      const comments: ThreadCommentRecord[] = thread.comments.nodes.map((comment) => ({
        author: comment.author?.login ?? "",
        body: comment.body ?? "",
        createdAt: comment.createdAt ?? null,
        url: comment.url ?? null,
      }));
      let commentPage = thread.comments.pageInfo;
      while (commentPage.hasNextPage) {
        if (!commentPage.endCursor) {
          throw new Error(`Review thread ${thread.id} is missing a comment pagination cursor.`);
        }
        const commentResponse = await octokit.graphql<GraphCommentsResponse>(THREAD_COMMENTS_QUERY, {
          threadId: thread.id,
          after: commentPage.endCursor,
        });
        const nextComments = commentResponse.node?.comments;
        if (!nextComments?.pageInfo || !Array.isArray(nextComments.nodes)) {
          throw new Error(`GitHub GraphQL did not return comments for review thread ${thread.id}.`);
        }
        comments.push(
          ...nextComments.nodes.map((comment) => ({
            author: comment.author?.login ?? "",
            body: comment.body ?? "",
            createdAt: comment.createdAt ?? null,
            url: comment.url ?? null,
          })),
        );
        commentPage = nextComments.pageInfo;
      }
      threads.push({
        id: thread.id,
        isResolved: thread.isResolved === true,
        isOutdated: thread.isOutdated === true,
        path: thread.path ?? null,
        line: thread.line ?? thread.originalLine ?? null,
        comments,
      });
    }
    if (!connection.pageInfo.hasNextPage) {
      break;
    }
    if (!connection.pageInfo.endCursor) {
      throw new Error("GitHub GraphQL reviewThreads pagination is missing endCursor.");
    }
    threadCursor = connection.pageInfo.endCursor;
  }

  return {
    repository,
    pullRequest,
    pullRequestUrl: pull.data.html_url,
    headSha,
    headCommittedAt:
      commit.data.commit.committer?.date ?? commit.data.commit.author?.date ?? null,
    reviews,
    reactions,
    issueComments,
    threads,
  };
}
