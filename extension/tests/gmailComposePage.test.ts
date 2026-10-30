import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { gmailComposePage } from "../src/tools/appdata/gmail/gmailComposePage.ts";

// A conversation of three messages: my own (Bcc to Jana), Jana's collapsed one and Jan's expanded last one.
const conversation = `<div role="main"><div role="list">
<div role="listitem"><span email="me@example.com" name="Me">Me</span><span email="jana@example.com">Bcc</span></div>
<div role="listitem" id="jana"><div class="kv"><span email="jana@example.com" name="Jana Kulířová">Jana</span></div>
  <div class="content" hidden><button aria-label="Odpovědět" id="jana-reply"></button></div></div>
<div role="listitem"><span email="jan@example.com" name="Jan">Jan</span><button aria-label="Odpovědět" id="jan-reply"></button></div>
</div><span class="ams bkH" hidden>Odpovědět</span></div>`;

// Jana's message hidden behind the count bubble of a longer conversation.
const janaMessage = conversation.match(/<div role="listitem" id="jana">[\s\S]*?<\/button><\/div><\/div>/)![0];
const bubbled = conversation.replace(janaMessage, `<div class="kQ adv"><span class="adx" role="button">1</span></div>`);

function page(recipient: string, html = conversation) {
  const dom = new JSDOM(html);
  const { window } = dom;
  const document = window.document;
  window.Element.prototype.checkVisibility = function (this: Element) { return !this.closest("[hidden]"); };
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get(this: HTMLElement) { return this.textContent ?? ""; } });
  const pressed: string[] = [];
  let editor: HTMLElement | null = null;
  document.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    pressed.push(target.id || target.className);
    if (target.className === "adx")
      target.parentElement!.outerHTML = janaMessage;
    if (target.className === "kv")
      document.querySelector("#jana .content")!.removeAttribute("hidden");
    if (target.id.endsWith("-reply")) {
      const compose = document.createElement("div");
      compose.innerHTML = `<div class="afV" data-hovercard-id="${recipient}" hidden>${recipient}</div><table><tr><td><div contenteditable="true" role="textbox"></div><div command="Files"></div></td></tr></table>`;
      document.body.append(compose);
      editor = compose.querySelector("[role='textbox']");
    }
  });
  document.execCommand = (command: string, _ui?: boolean, value?: string) => {
    editor!.textContent += command === "insertText" ? value! : "\n";
    return true;
  };
  const run = new Function("document", "window", "MouseEvent", "getSelection", "CSS", `return (${gmailComposePage.toString()});`)(
    document, window, window.MouseEvent, () => window.getSelection(), { escape: (value: string) => value }) as typeof gmailComposePage;
  return { run, pressed, editor: () => editor };
}

it("expands the sender's collapsed message and replies through its own reply button", async () => {
  const p = page("jana@example.com");
  expect(await p.run("reply", "Dobrý den,\nděkuji.", [], "Jana@Example.com")).toEqual({ kind: "filled", attached: [] });
  expect(p.pressed).toEqual(["kv", "jana-reply"]);
  expect(p.editor()!.textContent).toBe("Dobrý den,\nděkuji.");
});

it("types nothing when the opened reply does not show the sender among its recipients", async () => {
  const p = page("other@example.com");
  expect(await p.run("reply", "x", [], "jana@example.com")).toEqual({ kind: "other_recipient" });
  expect(p.editor()!.textContent).toBe("");
});

it("refuses a sender that has no message in the conversation", async () => {
  const p = page("x@example.com");
  expect(await p.run("reply", "x", [], "nobody@example.com")).toEqual({ kind: "no_message" });
  expect(p.pressed).toEqual([]);
});

it("opens the count bubble that hides the sender's message first", async () => {
  const p = page("jana@example.com", bubbled);
  expect(await p.run("reply", "x", [], "jana@example.com")).toEqual({ kind: "filled", attached: [] });
  expect(p.pressed).toEqual(["adx", "kv", "jana-reply"]);
});
