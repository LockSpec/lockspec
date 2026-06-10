import { z } from "zod";

export const activateVersionInputSchema = z.object({
  spec_id: z.string(),
  version: z.string(),
});
