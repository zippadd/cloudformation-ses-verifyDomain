rawTemplate="cf.yml"
packagedTemplate="cf-packaged.yml"
s3Prefix=${2-""}
s3PrefixOption="--s3-prefix"
appendRegion=${3-true}

if [ -z $1 ]; then
    echo "Usage: ./package.sh s3bucketName [s3Prefix appendRegion]"
    exit 1
fi

if [ "$s3Prefix" = "" ]; then
    s3PrefixOption=""
fi

lerna bootstrap &&
lerna clean --yes && #Remove node_modules
lerna exec -- yarn install --production && #Install only deps, not devDeps
for region in `cat regions`; do
  s3Bucket=$1
  if [ $appendRegion ]; then
      s3Bucket=$s3Bucket-$region
  fi
  lerna exec -- sam package --template-file $rawTemplate --s3-bucket $s3Bucket $s3PrefixOption $s3Prefix --output-template-file $region-$packagedTemplate &&
  lerna exec -- ln -fs $region-$packagedTemplate cf-packaged.yml
  sam package --template-file $rawTemplate --s3-bucket $s3Bucket $s3PrefixOption $s3Prefix --output-template-file $region-$packagedTemplate
  lerna exec -- rm cf-packaged.yml
done &&
lerna exec -- yarn install #Reinstall all deps
