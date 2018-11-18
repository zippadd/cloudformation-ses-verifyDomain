template="cf-packaged.yml"
stackName=${1:-"custom-resources"}

origRegion=`aws configure get region`

for region in `cat regions`; do
  aws configure set region $region
  sam deploy --template-file $region-$template --stack-name $stackName --capabilities CAPABILITY_NAMED_IAM #--parameter-overrides EnvironmentParameter=$npm_package_config_environment
done

aws configure set region $origRegion