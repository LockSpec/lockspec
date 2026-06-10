import { z } from "zod";

import { exactlyOneOperationRef, OPERATION_REF_MESSAGE } from "./operation_ref.js";

// Input schema for `validate_call`. Base registers via `.shape`; the `…Refined`
// variant carries the operation_id/operation_key XOR and is what the handler
// validates against.
export const validateCallInputSchema = z.object({
  operation_id: z.string().optional(),
  operation_key: z.string().optional(),
  spec_id: z.string().optional(),
  version: z.string().optional(),
  request: z.object({
    path_params: z.record(z.string(), z.unknown()).optional(),
    query_params: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    cookie_params: z.record(z.string(), z.unknown()).optional(),
    body: z.unknown().optional(),
    content_type: z.string().optional(),
  }),
});

export const validateCallInputSchemaRefined = validateCallInputSchema.refine(
  exactlyOneOperationRef,
  { message: OPERATION_REF_MESSAGE },
);
