/**
 * FRIDAY · desktop companion — overlay route.
 *
 * The transparent overlay window (electron/character/overlay.cjs) loads this
 * route and nothing else. It intentionally does NOT mount AppShell: the
 * console chrome, sidebar, boot screen and workspace gate belong to the main
 * window only. The body is forced transparent so the desktop shows through.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { CharacterStage } from "@/components/friday/character/CharacterStage";

export const Route = createFileRoute("/character")({
  head: () => ({
    meta: [
      { title: "FRIDAY Companion" },
      {
        name: "description",
        content: "FRIDAY's desktop companion overlay window.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CharacterOverlayRoute,
});

function CharacterOverlayRoute() {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const previous = {
      htmlBg: html.style.background,
      bodyBg: body.style.background,
      overflow: body.style.overflow,
      margin: body.style.margin,
      cursor: body.style.cursor,
    };
    html.style.background = "transparent";
    body.style.background = "transparent";
    body.style.overflow = "hidden";
    body.style.margin = "0";
    body.classList.add("friday-overlay-body");
    return () => {
      html.style.background = previous.htmlBg;
      body.style.background = previous.bodyBg;
      body.style.overflow = previous.overflow;
      body.style.margin = previous.margin;
      body.style.cursor = previous.cursor;
      body.classList.remove("friday-overlay-body");
    };
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent">
      <CharacterStage />
    </div>
  );
}
