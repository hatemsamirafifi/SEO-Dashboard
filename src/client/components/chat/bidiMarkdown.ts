import type { ExtraProps } from "react-markdown";
import {
  firstTextDirection,
  splitTechnicalText,
  type TextDirection,
} from "./bidiText";

type Element = NonNullable<ExtraProps["node"]>;
type Child = Element["children"][number];

const compoundBlocks = new Set(["ul", "ol", "blockquote", "table"]);
const textBlocks = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "th",
  "td",
  "div",
]);
const listItemBlocks = new Set([
  "p",
  "ul",
  "ol",
  "blockquote",
  "table",
  "pre",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

function isolateText(child: Child): Child[] {
  if (child.type !== "text") return [child];
  const parts = splitTechnicalText(child.value);
  if (!parts.some((part) => part.isolate)) return [child];
  return parts.map(({ text, isolate }) =>
    isolate
      ? {
          type: "element",
          tagName: isolate,
          properties: { dir: "ltr" },
          children: [{ type: "text", value: text }],
        }
      : { type: "text", value: text },
  );
}

// Keep markers aligned at the list's start edge, including when one item is
// written in a different language. Tight lists have no paragraph wrappers.
function wrapListItemText(children: Child[]): Child[] {
  const result: Child[] = [];
  let inline: Child[] = [];
  function flushInline() {
    if (inline.some((child) => child.type !== "text" || child.value.trim())) {
      result.push({
        type: "element",
        tagName: "div",
        properties: {},
        children: inline,
      });
    } else {
      result.push(...inline);
    }
    inline = [];
  }
  for (const child of children) {
    if (child.type === "element" && listItemBlocks.has(child.tagName)) {
      flushInline();
      result.push(child);
    } else {
      inline.push(child);
    }
  }
  flushInline();
  return result;
}

function applyDirections(element: Element): TextDirection | undefined {
  const { tagName, properties } = element;
  if (
    tagName === "bdi" ||
    tagName === "bdo" ||
    tagName === "code" ||
    tagName === "pre"
  ) {
    properties.dir = "ltr";
    return;
  }

  const [label] = element.children;
  if (
    tagName === "a" &&
    element.children.length === 1 &&
    label?.type === "text" &&
    /^(?:https?:\/\/|www\.)\S+$/i.test(label.value)
  ) {
    properties.dir = "ltr";
    return;
  }

  element.children = element.children.flatMap(isolateText);
  if (tagName === "li") element.children = wrapListItemText(element.children);

  let direction: TextDirection | undefined;
  for (const child of element.children) {
    const childDirection =
      child.type === "element"
        ? applyDirections(child)
        : child.type === "text"
          ? firstTextDirection(child.value)
          : undefined;
    direction ??= childDirection;
  }

  // Native auto skips nested blocks with their own direction. Use the first
  // prose direction for the table's column order and the list's marker edge.
  if (compoundBlocks.has(tagName) && direction) properties.dir = direction;
  if (textBlocks.has(tagName) && direction) properties.dir = "auto";
  return direction;
}

export function rehypeBidiMarkdown() {
  return (root: { children: { type: string }[] }) => {
    // ReactMarkdown's HAST root holds elements, comments and doctype nodes.
    for (const child of root.children) {
      if (isElement(child)) applyDirections(child);
    }
  };
}

function isElement(node: { type: string }): node is Element {
  return node.type === "element";
}
