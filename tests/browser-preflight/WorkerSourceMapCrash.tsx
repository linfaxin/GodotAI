export function throwAuthoredSourceError(): never {
  const authored = () => {
    throw new Error('WORKER_SOURCE_MAP_AUTHOR_THROW');
  };
  return authored();
}
