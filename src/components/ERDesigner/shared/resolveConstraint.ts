/**
 * Three-tier constraint resolution: relation → table → project → default.
 * Mirrors the Rust `resolve_constraint_method` / `resolve_comment_format`.
 */

import { DEFAULT_CONSTRAINT_METHOD, DEFAULT_COMMENT_FORMAT } from './constraintConstants';

interface HasConstraintMethod {
  constraint_method?: string | null;
}

interface HasCommentFormat {
  comment_format?: string | null;
}

interface TableLike extends HasConstraintMethod, HasCommentFormat {}

interface ProjectLike {
  default_constraint_method?: string;
  default_comment_format?: string;
}

export function resolveConstraintMethod(
  relation?: HasConstraintMethod | null,
  table?: TableLike | null,
  project?: ProjectLike | null,
): string {
  return relation?.constraint_method
    ?? table?.constraint_method
    ?? project?.default_constraint_method
    ?? DEFAULT_CONSTRAINT_METHOD;
}

export function resolveCommentFormat(
  relation?: HasCommentFormat | null,
  table?: TableLike | null,
  project?: ProjectLike | null,
): string {
  return relation?.comment_format
    ?? table?.comment_format
    ?? project?.default_comment_format
    ?? DEFAULT_COMMENT_FORMAT;
}
