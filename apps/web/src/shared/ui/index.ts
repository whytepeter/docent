export { Icon, type IconName } from "./Icon.tsx";
export { Group } from "./Group.tsx";
import "./inspector.css";
export { Commits } from "./Commits.tsx";
export const shortPath = (path: string, keep = 2) => path.split("/").slice(-keep).join("/");
