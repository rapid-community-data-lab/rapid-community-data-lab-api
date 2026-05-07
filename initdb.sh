createuser -d rapid_community_data_lab_api
psql -c "ALTER USER rapid_community_data_lab_api PASSWORD 'rapid_community_data_lab_api';"
createdb -O rapid_community_data_lab_api rapid_community_data_lab_api
