/** Types for the OpenCode plugin in opencode-task-scope.mjs, for its tests. */
export interface TaskScopeClient {
  session: {
    get(options: { path: { id: string }; sessionID: string }): Promise<{
      data?: { id: string; parentID?: string } | undefined;
      response?: { status: number } | undefined;
    }>;
  };
}

export interface TaskScopeHooks {
  'tool.execute.before': (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
}

export declare const CezarTaskScope: (input: { client: TaskScopeClient }) => Promise<TaskScopeHooks>;
