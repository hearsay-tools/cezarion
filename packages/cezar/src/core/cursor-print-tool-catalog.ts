/** A build that no longer advertises one of these cannot do the work of a print session,
 * so the capability preflight keeps it off print (hearsay-tools/cezarion#1257). */
export const CORE_CURSOR_PRINT_TOOLS = [
  'shell_tool_call',
  'read_tool_call',
  'edit_tool_call',
  'glob_tool_call',
  'grep_tool_call',
  'ls_tool_call',
  'delete_tool_call',
  'mcp_tool_call',
] as const;
