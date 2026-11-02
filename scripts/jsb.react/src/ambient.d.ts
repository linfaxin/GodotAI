declare module "react-reconciler" {
  const createReconciler: (configuration: Record<string, unknown>) => any;
  export default createReconciler;
}
declare function setTimeout(callback: () => void, delay?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare const console: { error(...values: unknown[]): void; warn(...values: unknown[]): void };
