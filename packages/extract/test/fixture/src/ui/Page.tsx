import { upload } from "../lib";
import { Button } from "./Button";

export function Page() {
  const onSave = () => upload("a.jpg");
  onSave();
  return <Button />;
}
