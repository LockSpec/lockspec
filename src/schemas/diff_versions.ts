import { z } from "zod";

const endpoint = z.object({
  spec_id: z.string().optional(),
  version: z.string(),
});

export const diffVersionsInputSchema = z.object({
  from: endpoint,
  to: endpoint,
  scope: z.enum(["operations", "types", "all"]).optional(),
  include_descriptions: z.boolean().optional(),
});
