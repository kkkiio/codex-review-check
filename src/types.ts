export type ReviewHintPolicy = "suggest" | "suppress";

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
  body: string;
  createdAt: string | null;
  url: string | null;
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
  | { kind: "none"; name: "none"; commitRef: null };

export interface SummaryRow {
  /** Review label with emoji and emphasis stripped, e.g. `Code Review`. */
  review: string;
  status: "running" | "completed" | "unknown";
  /** Start time while running, completion time once completed. */
  at: string | null;
  /** Lowercase abbreviated commit, or null when the cell has none. */
  commitRef: string | null;
  trigger: string;
}

export interface ReviewEvaluation {
  phase: "blocked" | "terminal" | "awaiting-lgtm" | "reviewing" | "missing";
  signal: string;
  unresolvedThreads: ReviewThreadRecord[];
  /**
   * True when the configured terminal pass-condition is already satisfied by
   * existing evidence, even while threads still block: any terminal evidence
   * in lenient mode, or a current-HEAD LGTM in strict mode.
   */
  currentHeadTerminal: boolean;
  /** True when the summary's Code Review row shows a review of the current HEAD is running. */
  currentHeadLiveness: boolean;
  /** Epoch milliseconds of the selected terminal artifact; null outside the terminal phase. */
  terminalAt: number | null;
}
