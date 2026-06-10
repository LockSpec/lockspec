import { z } from "zod";

export const loadSpecInputSchema = z.object({
  source: z.string(),
  source_type: z.enum(["file", "url", "inline"]).optional(),
  spec_id: z.string().optional(),
  label: z.string().optional(),
  version_label: z.string().optional(),
  activate: z.boolean().optional(),
});
