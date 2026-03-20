set REGION=canadacentral
set KEY=

python LineSyn.py --threads 10 --voice en-gb-sonia:DragonHDV2.5Neural --key %KEY% --region %REGION% --output sonia SpeechArena.txt --locale en-GB
python LineSyn.py --threads 10 --voice en-us-ava:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output ava_engb SpeechArena.txt --locale en-GB
python LineSyn.py --threads 10 --voice en-gb-ollie:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output ollie SpeechArena.txt --locale en-GB
python LineSyn.py --threads 10 --voice en-us-andrew:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output andrew_engb SpeechArena.txt --locale en-GB


python LineSyn.py --threads 10 --voice en-us-ava:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output ava SpeechArena.txt  --locale en-US
python LineSyn.py --threads 10 --voice en-us-serena:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output serena SpeechArena.txt  --locale en-US
python LineSyn.py --threads 10 --voice en-us-andrew2:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output andrew2 SpeechArena.txt  --locale en-US
python LineSyn.py --threads 10 --voice en-us-brian:DragonHDV2.5Neural  --key %KEY% --region %REGION% --output brian SpeechArena.txt  --locale en-US

