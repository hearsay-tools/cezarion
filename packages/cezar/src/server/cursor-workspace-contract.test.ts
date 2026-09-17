import { describe, expect, it } from 'vitest';
import {
  runnerModelsSchema, setConfigInputSchema, setWorkspaceConfigInputSchema,
  setWorkspaceUiStateInputSchema, workspaceConfigResponseSchema, workspaceUiStateSchema,
} from '@open-mercato/cezar-contract';

describe('Cursor workspace contract maps', () => {
  it('retains Cursor model defaults in both directions at both scopes', () => {
    const models = { cursor: 'model[effort=high]' };
    expect(runnerModelsSchema.parse(models)).toEqual(models);
    expect(setConfigInputSchema.parse({ defaultModels: models })).toEqual({ defaultModels: models });
    expect(setWorkspaceConfigInputSchema.parse({ agentDefaults: { models } })).toEqual({ agentDefaults: { models } });
    expect(workspaceConfigResponseSchema.shape.agentDefaults.parse({ models })).toEqual({ models });
  });
  it('retains Cursor auth incident dismissals in state and mutation bodies', () => {
    const state = { dismissedProviderAuthFailures: { cursor: 'incident-1' } };
    expect(workspaceUiStateSchema.parse(state)).toEqual(state);
    expect(setWorkspaceUiStateInputSchema.parse(state)).toEqual(state);
  });
});
