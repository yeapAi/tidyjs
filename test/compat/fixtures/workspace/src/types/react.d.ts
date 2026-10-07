declare module 'react' {
    export type FC<P = object> = (props: P) => unknown;
    export function useState<T>(initial: T): [T, (value: T) => void];
    export function useMemo<T>(factory: () => T, deps: unknown[]): T;
    const React: { version: string };
    export default React;
}
