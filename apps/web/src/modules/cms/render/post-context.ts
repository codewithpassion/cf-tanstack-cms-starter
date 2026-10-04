import { createContext, useContext } from "react";

/**
 * True inside a blog post's layout (post-article.tsx, and the editor's post canvas): the richText
 * block then renders the post body's article typography. Other blocks and other rich text (FAQ
 * answers, callouts) keep their own look.
 */
export const PostContext = createContext(false);

export function useInPost(): boolean {
  return useContext(PostContext);
}
