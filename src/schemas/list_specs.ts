import { z } from "zod";

export const listSpecsInputSchema = z.object({
  spec_id: z.string().optional(),
});
