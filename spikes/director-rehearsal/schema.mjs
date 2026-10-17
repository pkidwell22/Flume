// A strict proposed response protocol, not an application/domain API schema.
const str = {type: 'string', minLength: 1};
const integer = {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER};
const nullableId = {anyOf: [str, {type: 'null'}]};
const enumOf = (...values) => ({enum: values});
const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
const array = (items, extra = {}) => ({type: 'array', items, ...extra});
const binding = object({role: enumOf('first_frame', 'last_frame', 'soft_reference'), assetId: str, revision: integer});
const bindings = array(binding, {maxItems: 8});
const patch = object({prompt: str, routeId: str, bindings});
const args = {
  inspect_project: object({projectId: str}),
  resume_attempt: object({attemptId: str, mode: enumOf('read_only', 'same_key_replay')}),
  save_draft: object({shotId: str, expectedRevision: integer, patch}),
  submit_review: object({commandId: str, reviewId: str, grantId: str}),
  replay_command: object({commandId: str}),
  retry_retrieval: object({attemptId: str, outputId: str}),
  request_cancel: object({attemptId: str}),
  select_take: object({shotId: str, takeId: str, expectedSelectionRevision: integer}),
};
export const responseSchema = object({
  version: {const: 1},
  decisions: array(object({
    caseId: enumOf('C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08'),
    disposition: enumOf('hold', 'propose'),
    reason: enumOf('capability_conflict', 'revision_conflict', 'acceptance_uncertain', 'allowance_exhausted', 'recover_receipt', 'recover_output', 'authorized'),
    actions: array({oneOf: Object.entries(args).map(([name, schema]) => object({op: {const: name}, args: schema}))}, {maxItems: 2}),
    suggestedRouteId: nullableId,
    basis: object({draftRevision: integer, prompt: str, routeId: str, bindings, attemptId: nullableId, specId: nullableId, ownedTakeIds: array(str, {uniqueItems: true}), selectedTakeId: nullableId}),
    state: object({remoteKnowledge: enumOf('not_dispatched', 'unknown', 'accepted', 'running', 'succeeded', 'failed', 'cancelled'), cancellation: enumOf('none', 'requested', 'confirmed'), reservation: enumOf('none', 'held', 'released')}),
  }), {minItems: 8, maxItems: 8}),
});
