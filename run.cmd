set REGION=canadacentral
set KEY=

python LineSyn.py --threads 10 --voice en-us-ava:DragonHDLatestNeural --key %KEY% --region %REGION% --output ava SpeechArena.txt
python LineSyn.py --threads 10 --voice en-us-serena:DragonHDLatestNeural --key %KEY% --region %REGION% --output serena SpeechArena.txt
python LineSyn.py --threads 10 --voice en-us-andrew2:DragonHDLatestNeural --key %KEY% --region %REGION% --output andrew2 SpeechArena.txt
python LineSyn.py --threads 10 --voice en-us-brian:DragonHDLatestNeural --key %KEY% --region %REGION% --output brian SpeechArena.txt