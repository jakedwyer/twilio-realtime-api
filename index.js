import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';

// Load environment variables from .env file
dotenv.config();
// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}
// Add Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioPhoneNumber) {
    console.error('Missing Twilio credentials. Please set them in the .env file.');
    process.exit(1);
}

const client = twilio(accountSid, authToken);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = 'You are a fast talking ticket sales agent for the University of Virginia Basketall team. You are calling to try to get someone to upgrade their tickets since so many people have cancelled their seats after coach Tony Bennett retired. Incentivize the buyer with deeply discounted prices and opportunities to buy used team undergarments. Be flirty and bubbly and act like you are calling a friend. Introduce yourself as Monica and ask what their name is so you can use it in all responses once you have it. When you get the persons name always use it when speaking with them. Your goal is to sell tickets and to make the person uncomfortable.';
const VOICE = 'shimmer';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});
// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect record="true"
                                         recordingStatusCallback="https://${request.headers.host}/recording-status"
                                         recordingStatusCallbackMethod="POST">
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

// New route to initiate an outgoing call
fastify.post('/outgoing-call', async (request, reply) => {
    const { to } = request.body;

    if (!to) {
        reply.code(400).send({ error: 'Missing "to" phone number' });
        return;
    }

    try {
        const call = await client.calls.create({
            url: `https://${request.headers.host}/outgoing-call-handler`,
            to: to,
            from: twilioPhoneNumber,
            record: true

        });

        reply.send({ message: 'Outgoing call initiated', callSid: call.sid });
    } catch (error) {
        console.error('Error initiating outgoing call:', error);
        reply.code(500).send({ error: 'Failed to initiate outgoing call' });
    }
});

// Handler for outgoing call TwiML
fastify.all('/outgoing-call-handler', async (request, reply) => {
    console.log('Received request for outgoing call handler');
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect record="true"
                                         recordingStatusCallback="https://${request.headers.host}/recording-status"
                                         recordingStatusCallbackMethod="POST">
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('WebSocket connection established for media stream');
        let streamSid = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500 // Adjusted for quicker turn detection
                    },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    max_response_output_tokens: 1000
                }
            };
            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        });

        // Listen for messages from the OpenAI WebSocket
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }
                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
                if (response.type === 'response.content.delta' && response.delta && response.delta.text) {
                    console.log('AI response:', response.delta.text);
                }
                if (response.type === 'response.done') {
                    console.log('Response completed or cancelled:', response);
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));

                            // The API handles interruption based on turn detection settings
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    case 'stop':
                        console.log('Stream stopped');
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });
        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Callback for when the recording is complete
fastify.post('/recording-callback', async (request, reply) => {
    console.log('Recording completed:', request.body);
    // You can add logic here to process the completed recording
    reply.send({ status: 'success' });
});

// Callback for recording status updates
fastify.post('/recording-status', async (request, reply) => {
    console.log('Recording status update:', request.body);
    // Add logic here to handle different recording statuses
    reply.send({ status: 'received' });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
