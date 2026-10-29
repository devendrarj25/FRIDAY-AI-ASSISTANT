import { createContext } from "react";

/** True inside the app shell, so a page renders its frame instead of the whole chrome. */
export const ShellPresenceContext = createContext(false);
