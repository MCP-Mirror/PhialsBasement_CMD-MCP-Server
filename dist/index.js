#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from 'child_process';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
// Schema definitions
const ExecuteCommandArgsSchema = z.object({
    command: z.string(),
});
// Server setup
const server = new Server({
    name: "cmd-server",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "execute_command",
                description: "Execute a CMD command and return its output. " +
                    "This tool allows running any valid CMD command and captures both stdout and stderr.",
                inputSchema: zodToJsonSchema(ExecuteCommandArgsSchema),
            },
        ],
    };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const { name, arguments: args } = request.params;
        if (name === "execute_command") {
            const parsed = ExecuteCommandArgsSchema.safeParse(args);
            if (!parsed.success) {
                throw new Error(`Invalid arguments for execute_command: ${parsed.error}`);
            }
            return new Promise((resolve) => {
                const cmdProcess = spawn('cmd', ['/c', parsed.data.command]);
                let output = '';
                let errorOutput = '';
                cmdProcess.stdout.on('data', (data) => {
                    output += data.toString();
                });
                cmdProcess.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });
                cmdProcess.on('close', (code) => {
                    const finalOutput = output + (errorOutput ? `\nErrors:\n${errorOutput}` : '');
                    resolve({
                        content: [{
                                type: "text",
                                text: finalOutput || `Command completed with code ${code}`
                            }],
                        isError: code !== 0,
                    });
                });
            });
        }
        throw new Error(`Unknown tool: ${name}`);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            isError: true,
        };
    }
});
// Start server
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("CMD Server running on stdio");
}
runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
