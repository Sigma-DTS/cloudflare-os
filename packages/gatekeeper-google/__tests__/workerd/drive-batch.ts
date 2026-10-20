/**
 * One multipart `files.get` batch response, echoing each requested ID by Content-ID position: the
 * file `lookup` finds, or a 404 when it finds none.
 */
export function driveBatchResponse(body: string, lookup: (id: string) => unknown): Response {
  const boundary = "batch";
  const ids = [...body.matchAll(/GET \/drive\/v3\/files\/([^?]+)\?/g)]
    .map(match => decodeURIComponent(match[1]));
  const parts = ids.map((id, index) => {
    const file = lookup(id);
    return [
      `--${boundary}`, "Content-Type: application/http", `Content-ID: <response-item-${index}>`, "",
      file ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found", "Content-Type: application/json", "",
      JSON.stringify(file ?? {}),
    ].join("\r\n");
  });
  return new Response(`${parts.join("\r\n")}\r\n--${boundary}--\r\n`, {
    headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
  });
}
