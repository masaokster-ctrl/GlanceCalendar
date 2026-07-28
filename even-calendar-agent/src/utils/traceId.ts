/**
 * X-Cloud-Trace-Context: "TRACE_ID/SPAN_ID;o=1" の先頭 TRACE_ID 部分だけを取り出す。
 * ヘッダー全体はログに出さない。
 */
export function extractTraceId(header: string | undefined | null): string | null {
  if (!header) {
    return null;
  }

  const slashIndex = header.indexOf('/');
  const id = slashIndex === -1 ? header : header.slice(0, slashIndex);
  return id.length > 0 ? id : null;
}
