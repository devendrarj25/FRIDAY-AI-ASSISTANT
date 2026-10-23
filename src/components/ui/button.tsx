import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { Loader2 } from "lucide-react";
import { iconForLabel } from "@/components/friday/button-icons";
import { followPending, isThenable } from "@/lib/friday/pending-action";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "friday-btn inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow not-disabled:hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm not-disabled:hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm not-disabled:hover:bg-secondary/80",
        ghost: "not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 not-disabled:hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * The leading text of a button whose children are only text (a string, a
 * number, or several of them). Anything with an element child (an icon, a
 * spinner, a badge) returns null, so a button that already has its own
 * icon is never given a second one.
 */
function plainLabel(children: React.ReactNode): string | null {
  const parts = React.Children.toArray(children);
  if (!parts.length) return null;
  if (!parts.every((part) => typeof part === "string" || typeof part === "number")) return null;
  const text = parts.join("").trim();
  return text || null;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, children, onClick, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    // A click handler that returns a promise puts the button in a pending
    // state until it settles: spinner at once, disabled (no double submit),
    // and a failure becomes an error toast. Handlers returning nothing, and
    // asChild buttons (the child owns the click), are untouched.
    const [pending, setPending] = React.useState(false);
    const alive = React.useRef(true);
    React.useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
      };
    }, []);
    const label =
      asChild || size === "icon" || (props as Record<string, unknown>)["data-no-icon"] !== undefined
        ? null
        : plainLabel(children);
    const handleClick =
      onClick && !asChild
        ? (event: React.MouseEvent<HTMLButtonElement>) => {
            if (pending) return;
            const result: unknown = onClick(event);
            if (isThenable(result)) {
              setPending(true);
              followPending(
                result,
                () => {
                  if (alive.current) setPending(false);
                },
                label ?? props["aria-label"] ?? props.title ?? "",
              );
            }
          }
        : onClick;
    // FRIDAY Glass: every text button gets its icon from one vocabulary
    // (button-icons.ts). Opt out with data-no-icon; links (asChild) and
    // icon-sized buttons are left alone.
    const icon = label ? iconForLabel(label) : null;
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        data-variant={variant ?? "default"}
        data-size={size ?? "default"}
        data-pending={pending ? "true" : undefined}
        aria-busy={pending || undefined}
        ref={ref}
        {...(handleClick ? { onClick: handleClick } : {})}
        {...(disabled !== undefined || pending ? { disabled: Boolean(disabled) || pending } : {})}
        {...props}
      >
        {/* Without an icon the children pass through untouched: asChild
            (Slot) needs exactly one child element. */}
        {pending ? (
          <>
            <Loader2 aria-hidden="true" className="friday-pending-spinner animate-spin" />
            {children}
          </>
        ) : icon ? (
          <>
            {React.createElement(icon, { "aria-hidden": true, className: "friday-auto-icon" })}
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
