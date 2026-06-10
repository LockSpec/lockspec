import { z } from "zod";

export const removeSpecInputSchema = z.object({
  spec_id: z.string(),
  version: z.string().optional(),
  confirm: z.literal(true),
});
