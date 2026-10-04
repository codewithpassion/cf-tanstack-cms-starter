import { motion } from "framer-motion";
import type { ReactNode } from "react";

import { useEditMode } from "./edit-mode";
import { useInPost } from "./post-context";

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
};

/**
 * Fade-in on scroll. Static in the editor so the canvas never shows hidden content, and inside a
 * blog post, whose article column already fades in as a whole (post-layout.tsx).
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 30,
}: RevealProps) {
  const { editing } = useEditMode();
  const inPost = useInPost();
  if (editing || inPost) {
    return <div className={className}>{children}</div>;
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, delay }}
    >
      {children}
    </motion.div>
  );
}
