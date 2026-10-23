import { createContext, useContext } from 'react';
import { getIn, issueAt, type Def, type Issue } from './model';

export interface BuilderCtx {
  def: Def;
  setDef: (updater: (d: Def) => Def) => void;
  /** set a dotted path; `undefined` removes the key */
  set: (path: string, value: unknown) => void;
  issues: Issue[];
  showErrors: boolean;
  isEdit: boolean;
}

export const BuilderContext = createContext<BuilderCtx | null>(null);

export function useBuilder(): BuilderCtx {
  const c = useContext(BuilderContext);
  if (!c) throw new Error('useBuilder outside provider');
  return c;
}

/** value + setter + error for a dotted path */
export function useField<T = string>(path: string, fallback?: T) {
  const { def, set, issues, showErrors } = useBuilder();
  const raw = getIn(def, path) as T | undefined;
  return {
    value: (raw ?? fallback) as T,
    set: (v: T | undefined) => set(path, v),
    error: showErrors ? issueAt(issues, path) : undefined,
  };
}
