import dotenv from 'dotenv';
import twilio from 'twilio';
import readline from 'readline';

// Load environment variables
dotenv.config();

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const serverUrl = process.env.SERVER_URL; // Add this to your .env file

if (!accountSid || !authToken || !twilioPhoneNumber || !serverUrl) {
    console.error('Missing Twilio credentials or server URL. Please check your .env file.');
    process.exit(1);
}

const client = twilio(accountSid, authToken);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Enter the phone number to call (in E.164 format, e.g., +1234567890): ', (phoneNumber) => {
    makeOutgoingCall(phoneNumber);
    rl.close();
});

async function makeOutgoingCall(to) {
    try {
        const call = await client.calls.create({
            url: `${serverUrl}/outgoing-call-handler`,
            to: to,
            from: twilioPhoneNumber
        });

        console.log(`Outgoing call initiated. Call SID: ${call.sid}`);
        console.log(`Call status: ${call.status}`);
        console.log(`Call direction: ${call.direction}`);
        console.log(`Call to: ${call.to}`);
        console.log(`Call from: ${call.from}`);
        console.log(`Call URL: ${call.url}`);

        // Monitor call status
        monitorCallStatus(call.sid);
    } catch (error) {
        console.error('Error initiating outgoing call:', error);
    }
}

function monitorCallStatus(callSid) {
    const interval = setInterval(async () => {
        try {
            const call = await client.calls(callSid).fetch();
            console.log(`Call status: ${call.status}`);
            if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(call.status)) {
                clearInterval(interval);
            }
        } catch (error) {
            console.error('Error fetching call status:', error);
            clearInterval(interval);
        }
    }, 5000); // Check every 5 seconds
}
