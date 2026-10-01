import "server-only";

interface Result<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

/**
 * Returns `data` or throws. Database error details are logged on the server
 * and never sent to the client.
 */
export function unwrap<T>(result: Result<T>): T {
  if (result.error) {
    console.error("[db]", result.error.code, result.error.message);
    throw new Error("Databasfel");
  }
  return result.data as T;
}
