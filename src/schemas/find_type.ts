import { z } from "zod";

export const findTypeInputSchema = z.object({
  query: z.string(),
  spec_id: z.string().optional(),
  version: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
