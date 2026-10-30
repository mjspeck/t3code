export type CodeNavigationCommand =
  | "definition"
  | "peek"
  | "typeDefinition"
  | "implementations"
  | "references"
  | "rename"
  | "documentSymbols"
  | "workspaceSymbols"
  | "back"
  | "forward";

type Listener = (command: CodeNavigationCommand) => void;

const listeners = new Set<Listener>();

export function requestCodeNavigation(command: CodeNavigationCommand): boolean {
  const listener = [...listeners].at(-1);
  if (!listener) return false;
  listener(command);
  return true;
}

export function subscribeCodeNavigation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
