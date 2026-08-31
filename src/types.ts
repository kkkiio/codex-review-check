export type OutdatedPolicy = "block" | "ignore";

export interface ReviewRecord {
  author: string;
  state: string;
  commitId: string;
  submittedAt: string | null;
  url: string | null;
}

export interface ReactionRecord {
  author: string;
  content: string;
  createdAt: string | null;
}

export interface IssueCommentRecord {
  author: string;
  authorType: string | null;
  appSlug: string | null;
  body: string;
  createdAt: string | null;
  url: string | null;
  reactions: ReactionRecord[];
}

export interface ThreadCommentRecord {
  author: string;
  body: string;
  createdAt: string | null;
  url: string | null;
}

export interface ReviewThreadRecord {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ThreadCommentRecord[];
}

export interface ReviewSnapshot {
  repository: string;
  pullRequest: number;
  pullRequestUrl: string;
  headSha: string;
  headCommittedAt: string | null;
  reviews: ReviewRecord[];
  reactions: ReactionRecord[];
  issueComments: IssueCommentRecord[];
  threads: ReviewThreadRecord[];
}

export type IssueCommentSignal =
  | { kind: "terminal"; name: "clean-comment"; commitRef: string }
  | { kind: "liveness"; name: "progress-comment"; commitRef: null }
  | { kind: "none"; name: "none"; commitRef: null };

export interface ReviewEvaluation {
  phase: "terminal" | "reviewing" | "missing";
  signal: string;
  unresolvedThreads: ReviewThreadRecord[];
}
