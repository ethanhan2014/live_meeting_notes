// Separate profile keeps synthetic checks away from real meetings and saved settings.
const {app}=require('electron');
const path=require('node:path');
const os=require('node:os');
app.setPath('userData',process.env.MEETING_SMOKE_DATA||path.join(os.tmpdir(),'live-meeting-notes-smoke'));
require('../main.cjs');
