// Shared cross-field rule for tools that target one operation by either
// operation_id or operation_key:
// exactly one must be supplied. Single-sourced here; both schemas refine with it.
export const OPERATION_REF_MESSAGE =
  "Provide exactly one of operation_id or operation_key.";

export const exactlyOneOperationRef = (v: {
  operation_id?: string;
  operation_key?: string;
}): boolean => (v.operation_id === undefined) !== (v.operation_key === undefined);
