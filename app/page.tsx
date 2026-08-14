import { redirect } from "next/navigation";

// The digest is the primary surface, so it is what the root resolves to.
export default function Root() {
  redirect("/digest");
}
