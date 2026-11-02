import * as React from "react";

import { nameIfMissing } from "@/lib/friday/accessible-name";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "friday-field flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={(node) => {
          nameIfMissing(node);
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
