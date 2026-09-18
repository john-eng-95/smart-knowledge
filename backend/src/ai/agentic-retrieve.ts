import type { AuthUser } from '../auth/auth-user.interface';
import type { ChunkHit } from '../pipeline/types/pipeline.types';
import type {
  ChatQueryRewriteService,
  HitGrade,
} from './chat-query-rewrite.service';
import type { HybridRetrievalService } from './hybrid-retrieval.service';

/** Payload sent as data-eval; ok means the sources are relevant, not merely non-empty. */
export type RetrieveEvalReason =
  /** Relevant on the first retrieval. */
  | 'ok'
  /** Relevant after rewriting and retrying. */
  | 'retried_ok'
  /** No first-pass hits. */
  | 'empty'
  /** Still no hits after rewriting. */
  | 'retried_empty'
  /** First-pass hits were irrelevant. */
  | 'irrelevant'
  /** Still irrelevant after rewriting. */
  | 'retried_irrelevant'
  /** Retrieval failed. */
  | 'error';

export type RetrieveEval = {
  /** Whether the result can support an answer. */
  ok: boolean;
  reason: RetrieveEvalReason;
  /** Short explanation shown in the process trace. */
  text: string;
  /** Whether the query has already been rewritten and retried. */
  retried: boolean;
  /** First-pass query. */
  query: string;
  /** Rewritten query, present only for retries. */
  retryQuery?: string;
};

export type GradedRetrieve = {
  /** Raw hits for the rewriter; irrelevant hits must not support the answer. */
  rawHits: ChunkHit[];
  /** Relevant hits available for model citations. */
  hits: ChunkHit[];
  grade: HitGrade; // Original relevance judgment.
  eval: RetrieveEval; // Process trace payload.
  usedQuery: string; // Query actually sent to retrieval.
};

/** Empty result placeholder; do not call the grading model when there are no hits. */
const EMPTY_GRADE: HitGrade = {
  ok: false,
  reason: 'empty',
  text: 'No sources were found.',
};

/** One retrieval plus relevance grading. Every Agent loop retrieval calls this function. */
export async function retrieveAndGrade(opts: {
  question: string; // Original user question used for relevance grading.
  query: string; // Query for this pass, either the routed or rewritten query.
  topK: number; // Maximum number of returned hits.
  user?: AuthUser; // Visibility scope: public, team-shared, or authored by the user.
  retrieval: HybridRetrievalService; // Elasticsearch hybrid retrieval.
  rewrite: ChatQueryRewriteService; // Used only for gradeHits; rewriting happens outside.
  retried?: boolean; // Whether this is the second pass after rewriting.
  previousQuery?: string; // First-pass query displayed in eval.query.
}): Promise<GradedRetrieve> {
  const usedQuery = opts.query.trim() || opts.question;
  const retried = Boolean(opts.retried);
  const displayQuery = retried ? opts.previousQuery || usedQuery : usedQuery;
  const retryQuery = retried ? usedQuery : undefined;

  try {
    const rawHits = await opts.retrieval.retrieve(
      usedQuery,
      opts.topK,
      opts.user,
    );
    const grade = await opts.rewrite.gradeHits(opts.question, rawHits);
    return {
      rawHits,
      hits: grade.ok ? rawHits : [],
      grade,
      eval: toEval(grade, displayQuery, retried, retryQuery),
      usedQuery,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      rawHits: [],
      hits: [],
      grade: { ...EMPTY_GRADE, text: `Retrieval failed: ${detail}` },
      eval: {
        ok: false,
        reason: 'error',
        text: retried
          ? 'Retrieval failed after rewriting.'
          : 'Retrieval failed.',
        retried,
        query: displayQuery,
        retryQuery,
      },
      usedQuery,
    };
  }
}

/**
 * Equivalent loop for /ai/chat without an Agent: retrieve once -> grade -> rewrite and retry once when insufficient.
 */
export async function retrieveUntilRelevant(opts: {
  question: string; // Original user question.
  query: string; // First-pass query, usually produced by intent routing.
  topK: number; // Maximum number of returned hits.
  user?: AuthUser; // Document visibility scope.
  retrieval: HybridRetrievalService; // Elasticsearch hybrid retrieval.
  rewrite: ChatQueryRewriteService; // Relevance grading and fallback rewriting.
  onEval?: (data: RetrieveEval) => void; // Callback after each grading step.
  onRewrite?: (retryQuery: string) => void; // Callback before retrying with a new query.
}): Promise<{ hits: ChunkHit[]; eval: RetrieveEval; usedQuery: string }> {
  const first = await retrieveAndGrade({
    question: opts.question,
    query: opts.query,
    topK: opts.topK,
    user: opts.user,
    retrieval: opts.retrieval,
    rewrite: opts.rewrite,
  });
  opts.onEval?.(first.eval);
  if (first.eval.ok || first.eval.reason === 'error') {
    return { hits: first.hits, eval: first.eval, usedQuery: first.usedQuery };
  }

  const retryQuery = await opts.rewrite.rewriteAfterRetrieve(
    opts.question,
    first.usedQuery,
    first.grade,
    first.rawHits,
  );
  if (!retryQuery) {
    return { hits: [], eval: first.eval, usedQuery: first.usedQuery };
  }

  opts.onRewrite?.(retryQuery);
  const second = await retrieveAndGrade({
    question: opts.question,
    query: retryQuery,
    topK: opts.topK,
    user: opts.user,
    retrieval: opts.retrieval,
    rewrite: opts.rewrite,
    retried: true,
    previousQuery: first.usedQuery,
  });
  opts.onEval?.(second.eval);
  return { hits: second.hits, eval: second.eval, usedQuery: second.usedQuery };
}

function toEval(
  grade: HitGrade, // Result from gradeHits.
  query: string, // First-pass query shown in eval.query.
  retried: boolean, // Whether this was a rewritten retry.
  retryQuery?: string, // Query used for the second pass.
): RetrieveEval {
  if (grade.reason === 'relevant') {
    return {
      ok: true,
      reason: retried ? 'retried_ok' : 'ok',
      text: retried ? `Rewritten and retried: ${grade.text}` : grade.text,
      retried,
      query,
      retryQuery,
    };
  }
  if (grade.reason === 'empty') {
    return {
      ok: false,
      reason: retried ? 'retried_empty' : 'empty',
      text: retried ? 'No results after rewriting.' : grade.text,
      retried,
      query,
      retryQuery,
    };
  }
  return {
    ok: false,
    reason: retried ? 'retried_irrelevant' : 'irrelevant',
    text: retried
      ? `Still not relevant after rewriting: ${grade.text}`
      : grade.text,
    retried,
    query,
    retryQuery,
  };
}
