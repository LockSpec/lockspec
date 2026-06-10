import { z } from "zod";

import { exactlyOneOperationRef, OPERATION_REF_MESSAGE } from "./operation_ref.js";

// Input schema for `get_signature`. The base z.object registers with the SDK
// via `.shape` (both operation refs optional — a cross-field XOR can't ride in
// a raw shape). The `…Refined` variant carries the XOR.
export const getSignatureInputSchema = z.object({
  operation_id: z.string().optional(),
  operation_key: z.string().optional(),
  spec_id: z.string().optional(),
  version: z.string().optional(),
  expand_refs: z.boolean().optional(),
  max_depth: z.number().int().optional(),
});

export const getSignatureInputSchemaRefined = getSignatureInputSchema.refine(
  exactlyOneOperationRef,
  { message: OPERATION_REF_MESSAGE },
);
