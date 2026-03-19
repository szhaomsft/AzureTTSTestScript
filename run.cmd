set REGION=canadacentral
set KEY=

python LineSyn.py --threads 10 --voice en-gb-sonia:DragonHDV2.5Neural --key %KEY% --region %REGION% --output sonia SpeechArena.txt
python LineSyn.py --threads 10 --voice en-gb-ada:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output ada SpeechArena.txt
python LineSyn.py --threads 10 --voice en-gb-ollie:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output ollie SpeechArena.txt
python LineSyn.py --threads 10 --voice en-gb-ryan:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output ryan SpeechArena.txt


python LineSyn.py --threads 10 --voice en-us-ava:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output ava SpeechArena.txt
python LineSyn.py --threads 10 --voice en-us-serena:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output serena SpeechArena.txt
python LineSyn.py --threads 10 --voice en-us-andrew2:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output andrew2 SpeechArena.txt
python LineSyn.py --threads 10 --voice en-us-brian:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output brian SpeechArena.txt

