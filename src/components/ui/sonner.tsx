import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      // Corner popups must always go away on their own, and must always be
      // dismissable by hand. Anything that still needs attention afterwards
      // lives in the notification centre (see lib/friday/toast-bridge.ts).
      duration={6000}
      closeButton
      visibleToasts={2}
      style={
        {
          // Inline so they beat the library's own light/dark colour sets.
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          title: "group-[.toast]:text-foreground group-[.toast]:font-semibold",
          // The grey muted colour was almost invisible on the dark toast: the second line is the reason, so it reads like body text.
          description: "group-[.toast]:text-foreground/80",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
