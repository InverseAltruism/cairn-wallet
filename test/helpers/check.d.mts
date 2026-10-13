export interface Checker {
  check<T>(name: string, cond: T): T;
  done(label?: string): never;
  readonly pass: number;
  readonly fail: number;
}
export function checker(title?: string): Checker;
