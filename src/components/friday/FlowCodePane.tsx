/**
 * FRIDAY · code tab for one flow.
 *
 * Invalid text stays in the editor and does not replace the graph.
 */
import { useEffect, useRef } from "react";
import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { validateGraphText } from "@/lib/friday/flow-codec";

export function FlowCodePane({
  value,
  onValid,
  onIssue,
}: {
  value: string;
  onValid: (text: string) => void;
  onIssue: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const initial = useRef(value);
  const onValidRef = useRef(onValid);
  const onIssueRef = useRef(onIssue);

  useEffect(() => {
    onValidRef.current = onValid;
    onIssueRef.current = onIssue;
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          json(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            const checked = validateGraphText(text);
            if (!checked.ok) {
              onIssueRef.current(checked.errors.join(" "));
              return;
            }
            onIssueRef.current("");
            onValidRef.current(text);
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, []);

  return (
    <div
      ref={host}
      className="flow-code min-h-48 overflow-hidden rounded-md border border-border"
    />
  );
}
