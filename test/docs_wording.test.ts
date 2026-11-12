import { expect, test } from "bun:test";
import * as fs from "node:fs";

// The code has a type `Kind` whose values are "request" and "response". A docs
// page names the body instead: "when `lowerToWire` compiles a request body",
// not "for kind `"request"`". These tests fail when a Markdown file under
// docs/ puts the word "kind" next to the word "request" or "response".
//
// "kind" is also a param of `llm.server_tool` and of `gemini.part_meta`, with
// values such as "functionResponse", so the rule reads whole words only, and
// it stops at a comma and at the end of a sentence.
const kindWords = ["kind", "kinds"];
const bodyWords = [
    "request",
    "requests",
    "response",
    "responses",
    "response_stream",
];
// A kind word and a body word still match with these words between them, as
// in "the `kind` argument is `"request"`".
const wordsBetween = [
    "is",
    "are",
    "equals",
    "argument",
    "param",
    "parameter",
    "type",
    "value",
];

// A word is a run of letters, digits, and underscores. A dotted name such as
// `response.stop`, `response.*`, or `pipeline.ts` is one word, so an op name
// is never the word "response". A possessive "'s" is left out of the word.
// A dotted name that ends in `.kind` counts as the word "kind".
const word = /(?<word>\w+(?:\.[\w*]+)*)(?:['’]s\b)?/;
// Markdown emphasis puts an underscore on each side of a word or a phrase, as
// in `_kind_`. The underscores at the start and at the end of a word are not
// part of the word that the rule compares. `response_stream` keeps its
// underscore.
const emphasis = /^_+|_+$/g;
// A clause ends at one of these marks, at a blank line, and at a list marker.
// A colon does not end a clause: `kind: "request"` is one clause. Neither does
// a `!` directly before `=`: `kind !== "request"` is one clause.
const clauseEnd = /[,;()|.?]|!(?!=)|\n[ \t]*\n|\n[ \t]*[-*+][ \t]/;
const token = new RegExp(`${word.source}|${clauseEnd.source}`, "g");

type Finding = { line: number; text: string };

// Every place in one Markdown file where a kind word and a body word stand in
// the same clause with nothing between them but spaces, line breaks, quotes,
// backticks, other marks that do not end a clause, and `wordsBetween`. The
// function reads prose and inline code, and skips fenced code blocks, where a
// page prints a signature such as `kind: Kind` as the source declares it.
function kindWordings(markdown: string): Finding[] {
    let inFence = false;
    const prose = markdown
        .split("\n")
        .map((line) => {
            const isFence = /^\s*(```|~~~)/.test(line);
            if (isFence) inFence = !inFence;
            return isFence || inFence ? "" : line;
        })
        .join("\n");

    const findings: Finding[] = [];
    let previous: { isKind: boolean; start: number } | undefined;
    for (const match of prose.matchAll(token)) {
        const written = match.groups?.word;
        if (written === undefined) {
            previous = undefined;
            continue;
        }
        const found = written.toLowerCase().replace(emphasis, "");
        // An underscore alone closes an emphasised phrase, as in
        // "_the `"request"`_ kind", and is no word between the two words.
        if (found === "") continue;
        // `target.kind` names the same type, so its last part is read.
        const isKind = kindWords.includes(found.split(".").at(-1)!);
        if (!isKind && !bodyWords.includes(found)) {
            if (!wordsBetween.includes(found)) previous = undefined;
            continue;
        }
        if (previous && previous.isKind !== isKind) {
            // The message shows both words with their quotes and backticks.
            const start = /[`"']*$/.exec(prose.slice(0, previous.start))!.index;
            const end = match.index + written.length;
            findings.push({
                line: prose.slice(0, start).split("\n").length,
                text: (
                    prose.slice(start, end) +
                    /^[`"']*/.exec(prose.slice(end))![0]
                ).replace(/\s+/g, " "),
            });
        }
        previous = { isKind, start: match.index };
    }
    return findings;
}

const textsOf = (markdown: string) =>
    kindWordings(markdown).map((finding) => finding.text);

test('the rule matches "kind" next to "request" or "response"', () => {
    // The sentence that these tests exist for, with the page's line breaks.
    expect(
        kindWordings(
            [
                "# dropResponseOps",
                "",
                "```ts",
                "function dropResponseOps(program: Program): Program;",
                "```",
                "",
                "`dropResponseOps(program)` is in `src/core/pipeline.ts`. For kind",
                '`"request"`, `lowerToWire` calls `dropResponseOps` after',
                "`dropMetaOps`.",
            ].join("\n"),
        ),
    ).toEqual([{ line: 7, text: 'kind `"request"`' }]);

    // Each sentence, and the text that the rule matches in the sentence.
    const rejected: [sentence: string, matched: string][] = [
        // "kind" first, in prose and in inline code.
        ['For kind `"request"`, x.', 'kind `"request"`'],
        ['For the kinds `"request"` and `"response"`, x.', 'kinds `"request"`'],
        ['For Kind "request", x.', 'Kind "request"'],
        ["- one list item\n- for Kind REQUEST", "Kind REQUEST"],
        ["For a program of kind request, x.", "kind request"],
        ["For the kinds requests and responses, x.", "kinds requests"],
        ['For request bodies (kind `"request"`), x.', 'kind `"request"`'],
        ['When `kind === "request"`, x.', '`kind === "request"`'],
        ['When `kind !== "request"`, x.', '`kind !== "request"`'],
        ['With `kind: "request"`, x.', '`kind: "request"`'],
        [
            'When `target.kind` is `"response_stream"`, x.',
            '`target.kind` is `"response_stream"`',
        ],
        // Each of the words that may stand between the two words.
        ['When `kind` is `"request"`, x.', '`kind` is `"request"`'],
        [
            'The kinds are `"request"` and `"response"`.',
            'kinds are `"request"`',
        ],
        ['When `kind` equals `"response"`, x.', '`kind` equals `"response"`'],
        [
            'When the `kind` argument is `"request"`, x.',
            '`kind` argument is `"request"`',
        ],
        ['The `kind` param `"request"`, x.', '`kind` param `"request"`'],
        [
            'The `kind` parameter `"request"`, x.',
            '`kind` parameter `"request"`',
        ],
        ['The `kind` value `"request"`, x.', '`kind` value `"request"`'],
        [
            'The `Kind` type is `"request" | "response"`.',
            '`Kind` type is `"request"',
        ],
        // The body word first.
        ['For the `"request"` kind, x.', '`"request"` kind'],
        ['For the `"request"`\nkind, x.', '`"request"` kind'],
        ["For request-kind programs, x.", "request-kind"],
        ["Depending on the request's kind, x.", "request's kind"],
        ["Depending on the request’s kind, x.", "request’s kind"],
        ["The request and response kinds differ.", "response kinds"],
        ["The requests and responses kinds differ.", "responses kinds"],
        // Markdown emphasis.
        ['For _kind_ `"request"`, x.', '_kind_ `"request"`'],
        ["For the _request_ kind, x.", "_request_ kind"],
        ['For _the `"request"`_ kind, x.', '`"request"`_ kind'],
    ];
    expect(rejected.map(([sentence]) => [sentence, textsOf(sentence)])).toEqual(
        rejected.map(([sentence, matched]) => [sentence, [matched]]),
    );
});

test("the rule leaves a param named kind and other uses of the word alone", () => {
    const allowed = [
        // `kind` as a param of an op.
        '`gemini.part_meta` with `kind: "functionResponse"` carries the function `name`.',
        "| `llm.server_tool` | `name`, `kind` | hosted web search or code execution |",
        // The word in other senses, and a body word in the next clause.
        "A response keeps every other kind of text intact.",
        "This kind of text stays intact in a response.",
        "The two kinds of response differ.",
        "Most stages rewrite one op kind. Response ops pass through.",
        "Every op has one kind; response ops pass through.",
        "Which kind? Response ops only.",
        "Only one kind! Response ops pass through.",
        'In a response, `kind` is `"text"`.',
        'A text part in a response (`kind: "text"`) keeps its index.',
        "Gemini reads each part (by its kind) request by request.",
        "| `kind` | response part |",
        "Every op of one kind: `response.stop`.",
        "Every op of one kind: `response.*`.",
        "`dropResponseOps` removes every op of that kind\n\nResponse bodies keep the ops.",
        "- every op of that kind\n- response ops",
        "* every op of that kind\n* response ops",
        "+ every op of that kind\n+ response ops",
        // Fenced blocks.
        '```ts\nlow = kind === "request" ? dropResponseOps(low) : dropRequestOps(low);\n```',
        '~~~ts\nlow = kind === "request" ? dropResponseOps(low) : dropRequestOps(low);\n~~~',
    ];
    expect(allowed.filter((markdown) => textsOf(markdown).length > 0)).toEqual(
        [],
    );
});

test('no file under docs/ uses the word "kind" for a request body or a response body', () => {
    const docs = new URL("../docs/", import.meta.url);
    const pages = fs
        .readdirSync(docs, { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".md"))
        .sort();
    // A wrong directory would hold no page, and a listing of the top directory
    // only would skip the pages in subdirectories. The test would pass.
    expect(pages).toContain("core-ir.md");
    expect(pages).toContain("dialects/gemini.md");

    const messages = pages.flatMap((page) =>
        kindWordings(fs.readFileSync(new URL(page, docs), "utf8")).map(
            ({ line, text }) =>
                `docs/${page}:${line}: "${text}" uses the internal type name "kind" for a body. ` +
                'Write "request body" or "response body", as in ' +
                '"when `lowerToWire` compiles a request body". ' +
                'If "kind" here is a param of an op or the ordinary word, ' +
                'put a comma or a word such as "of" between "kind" and the body word, ' +
                'as in "In a response, `kind` is `"text"`" or "the two kinds of response".',
        ),
    );
    if (messages.length > 0) throw new Error(messages.join("\n"));
});
