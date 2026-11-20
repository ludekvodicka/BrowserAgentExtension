export type GmailSearchRow = { threadId: string; subject: string; from: string[]; date: string; snippet: string; unread: boolean; hasAttachment: boolean };
export type GmailSearchPageResult = { kind: "results"; range: string | null; truncated: boolean; threads: GmailSearchRow[] } | { kind: "timeout" };

// Runs isolated in a Gmail tab: shows the search there as the search box would (#search/<query>), waits until the visible result list
// is replaced and holds still, and reads its rows. Gmail keeps earlier lists in the page hidden; only visible rows count.
export async function gmailSearchPage(query: string, limit: number): Promise<GmailSearchPageResult> {
  const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const visible = (selector: string) => [...document.querySelectorAll(`div[role="main"] ${selector}`)].filter(element => element.checkVisibility());
  const rows = () => visible("tr.zA") as HTMLTableRowElement[];
  const threadSpan = (row: Element) => row.querySelector(".bog span[data-thread-id]") ?? row.querySelector("span[data-thread-id]");
  const signature = (shown: Element[]) => shown.map(row => threadSpan(row)?.getAttribute("data-thread-id") ?? "").join(",");
  const decoded = (hash: string) => { try { return decodeURIComponent(hash.replace(/\+/g, " ")); } catch { return hash; } };
  const target = `#search/${encodeURIComponent(query)}`;
  const before = rows();
  const navigated = decoded(location.hash) !== decoded(target);
  if (navigated)
    location.hash = target;
  const deadline = Date.now() + 10_000;
  let last: string | null = null;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const shown = rows();
    // An empty result shows Gmail's "no messages match" cell instead of rows; no rows and no such cell means still loading.
    const ready = shown.length > 0 || visible("td.TC").length > 0;
    const replaced = !navigated || shown.length !== before.length || shown.some((row, index) => row !== before[index]);
    const current = ready && replaced ? `${shown.length}:${signature(shown)}` : null;
    if (current !== null && current === last) {
      const threads = shown.map(row => {
        const span = threadSpan(row);
        const senders = [...row.querySelectorAll(".yW span[email]")].map(sender => {
          const email = sender.getAttribute("email") ?? "";
          const name = sender.getAttribute("name") ?? "";
          return name && name !== email ? `${name} <${email}>` : email;
        });
        const date = row.querySelector("td.xW span[title]");
        return { threadId: (span?.getAttribute("data-thread-id") ?? "").replace(/^#/, ""), subject: text(span), from: [...new Set(senders)],
          date: date?.getAttribute("title") ?? text(row.querySelector("td.xW")), snippet: text(row.querySelector("span.y2")).replace(/^-\s*/, "").slice(0, 300),
          unread: row.classList.contains("zE"), hasAttachment: row.querySelector("td.yf img") !== null };
      }).filter(thread => /^thread-(f:|a:r-?)\d{1,30}$/.test(thread.threadId));
      const range = visible(".Dj")[0];
      return { kind: "results", range: range ? text(range) : null, truncated: threads.length > limit, threads: threads.slice(0, limit) };
    }
    last = current;
    if (Date.now() >= deadline)
      return { kind: "timeout" };
  }
}
