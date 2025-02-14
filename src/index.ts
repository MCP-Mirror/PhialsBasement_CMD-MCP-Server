#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from 'child_process';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { platform } from 'os';
import { Client, ClientChannel } from 'ssh2';
import { join } from 'path';

// Schema definitions
const ExecuteCommandArgsSchema = z.object({
    command: z.string(),
    newSession: z.boolean().optional(),
});

const SSHConnectionArgsSchema = z.object({
    host: z.string(),
    port: z.number().default(22),
    username: z.string(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    command: z.string(),
    newSession: z.boolean().optional(),
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

let persistentCmd: ChildProcess | null = null;
let persistentSSH: {client: Client, ready: boolean} | null = null;
let persistentSSHConfig: {
    host: string,
    port: number,
    username: string,
    password?: string,
    privateKey?: string
} | null = null;

function initializePersistentCmd() {
    const isWindows = platform() === 'win32';
    if (persistentCmd) return;

    const shell = isWindows ? 
        join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : 
        '/bin/sh';

    persistentCmd = spawn(isWindows ? 'cmd.exe' : '/bin/sh', [], {
        windowsHide: true,
        shell: true  // This ensures proper path resolution
    });

    persistentCmd.on('error', (error) => {
        console.error('Error in persistent CMD:', error);
        persistentCmd = null;
    });

    persistentCmd.on('exit', () => {
        persistentCmd = null;
    });
}

async function executeSSHCommand(config: z.infer<typeof SSHConnectionArgsSchema>): Promise<{ output: string, code: number }> {
    return new Promise((resolve) => {
        const useNewSession = config.newSession || false;
        
        // Check if we need a new session or if connection details changed
        if (!useNewSession && persistentSSH?.ready && persistentSSHConfig &&
            persistentSSHConfig.host === config.host &&
            persistentSSHConfig.port === config.port &&
            persistentSSHConfig.username === config.username &&
            persistentSSHConfig.password === config.password &&
            persistentSSHConfig.privateKey === config.privateKey) {
            
            // Use existing connection
            persistentSSH.client.exec(config.command, (err: Error | undefined, stream: ClientChannel) => {
                if (err) {
                    resolve({ output: `SSH exec error: ${err.message}`, code: 1 });
                    return;
                }

                let output = '';
                let errorOutput = '';

                stream.on('close', (code: number) => {
                    resolve({ 
                        output: output + (errorOutput ? `\nErrors:\n${errorOutput}` : ''),
                        code: code || 0
                    });
                }).on('data', (data: Buffer) => {
                    output += data.toString('utf8');
                }).stderr.on('data', (data: Buffer) => {
                    errorOutput += data.toString('utf8');
                });
            });
            return;
        }

        // Need to create new connection
        const client = new Client();
        const sshConfig = {
            host: config.host,
            port: config.port,
            username: config.username,
            ...(config.password ? { password: config.password } : {}),
            ...(config.privateKey ? { privateKey: config.privateKey } : {}),
        };

        let output = '';
        let errorOutput = '';

        client.on('ready', () => {
            // If this is a persistent session, save the connection
            if (!useNewSession) {
                if (persistentSSH?.client) {
                    persistentSSH.client.end();
                }
                persistentSSH = { client, ready: true };
                persistentSSHConfig = sshConfig;
            }

            client.exec(config.command, (err: Error | undefined, stream: ClientChannel) => {
                if (err) {
                    resolve({ output: `SSH exec error: ${err.message}`, code: 1 });
                    if (useNewSession) client.end();
                    return;
                }

                stream.on('close', (code: number) => {
                    resolve({ 
                        output: output + (errorOutput ? `\nErrors:\n${errorOutput}` : ''),
                        code: code || 0
                    });
                    if (useNewSession) client.end();
                }).on('data', (data: Buffer) => {
                    output += data.toString('utf8');
                }).stderr.on('data', (data: Buffer) => {
                    errorOutput += data.toString('utf8');
                });
            });
        })
        .on('error', (err: Error) => {
            resolve({ output: `SSH connection error: ${err.message}`, code: 1 });
            if (useNewSession) client.end();
        })
        .connect(sshConfig);
    });
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "execute_command",
                description: "Execute a command and return its output. " +
                    "Commands run in a persistent shell session by default. " +
                    "Use newSession: true to run in a new shell instance.",
                inputSchema: zodToJsonSchema(ExecuteCommandArgsSchema),
            },
            {
                name: "execute_ssh_command",
                description: "Execute a command on a remote server via SSH. " +
                    "Commands run in a persistent SSH session by default. " +
                    "Use newSession: true to run in a new session.",
                inputSchema: zodToJsonSchema(SSHConnectionArgsSchema),
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
                const useNewSession = parsed.data.newSession || false;
                const isWindows = platform() === 'win32';
                
                if (useNewSession) {
                    const cmdProcess = spawn(isWindows ? 'cmd' : '/bin/sh', [], {
                        windowsHide: true,
                    });

                    let output = '';
                    let errorOutput = '';

                    cmdProcess.stdout.on('data', (data) => {
                        output += data.toString();
                    });

                    cmdProcess.stderr.on('data', (data) => {
                        errorOutput += data.toString();
                    });

                    cmdProcess.on('error', (error) => {
                        resolve({
                            content: [{ 
                                type: "text", 
                                text: `Failed to execute command: ${error.message}`
                            }],
                            isError: true,
                        });
                    });

                    cmdProcess.stdin.write(parsed.data.command + '\n');
                    cmdProcess.stdin.end();

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
                } else {
                    if (!persistentCmd) {
                        initializePersistentCmd();
                    }

                    if (!persistentCmd) {
                        throw new Error("Failed to initialize persistent CMD session");
                    }

                    let output = '';
                    let errorOutput = '';
                    let commandComplete = false;

                    const outputMarker = `__CMD_OUTPUT_${Date.now()}__`;
                    const markerCommand = isWindows ? `echo ${outputMarker}` : `echo "${outputMarker}"`;

                    const dataHandler = (data: Buffer) => {
                        const str = data.toString();
                        if (str.includes(outputMarker)) {
                            commandComplete = true;
                            return;
                        }
                        if (!commandComplete) {
                            output += str;
                        }
                    };

                    const errorHandler = (data: Buffer) => {
                        errorOutput += data.toString();
                    };

                    persistentCmd.stdout?.on('data', dataHandler);
                    persistentCmd.stderr?.on('data', errorHandler);

                    persistentCmd.stdin?.write(parsed.data.command + '\n' + markerCommand + '\n');

                    const checkInterval = setInterval(() => {
                        if (commandComplete) {
                            clearInterval(checkInterval);
                            persistentCmd?.stdout?.removeListener('data', dataHandler);
                            persistentCmd?.stderr?.removeListener('data', errorHandler);

                            const finalOutput = output + (errorOutput ? `\nErrors:\n${errorOutput}` : '');
                            resolve({
                                content: [{ 
                                    type: "text", 
                                    text: finalOutput || "Command completed"
                                }],
                                isError: false,
                            });
                        }
                    }, 50);

                    setTimeout(() => {
                        if (!commandComplete) {
                            clearInterval(checkInterval);
                            persistentCmd?.stdout?.removeListener('data', dataHandler);
                            persistentCmd?.stderr?.removeListener('data', errorHandler);
                            resolve({
                                content: [{ 
                                    type: "text", 
                                    text: "Command timed out"
                                }],
                                isError: true,
                            });
                        }
                    }, 30000);
                }
            });
        } else if (name === "execute_ssh_command") {
            const parsed = SSHConnectionArgsSchema.safeParse(args);
            if (!parsed.success) {
                throw new Error(`Invalid arguments for execute_ssh_command: ${parsed.error}`);
            }

            const { output, code } = await executeSSHCommand(parsed.data);
            return {
                content: [{ 
                    type: "text", 
                    text: output || `Command completed with code ${code}`
                }],
                isError: code !== 0,
            };
        }

        throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
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
    console.error("Command execution server running on stdio");
    initializePersistentCmd();
}

// Cleanup on exit
process.on('exit', () => {
    if (persistentCmd) {
        persistentCmd.kill();
    }
    if (persistentSSH?.client) {
        persistentSSH.client.end();
    }
});

runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
