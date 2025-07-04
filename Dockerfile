# Use the official Node.js 20 image as the base image
FROM node:20-slim

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
# This step is done separately to leverage Docker's caching,
# so npm install isn't re-run if only source code changes.
COPY package*.json ./

# Install application dependencies
# IMPORTANT CHANGE: Removed --production to ensure devDependencies (like typescript) are installed for the build step
RUN npm install 

# Copy the rest of the application source code
# We copy 'src' and 'tsconfig.json' specifically for TypeScript compilation
# Other files like .env and .gitignore are not copied as they are for local dev/git
COPY src ./src
COPY tsconfig.json .

# Build the TypeScript application
# This compiles TypeScript to JavaScript and puts it in the 'dist' folder
RUN npx tsc

# Expose the port your app runs on
EXPOSE 3001

# Define the command to run your application
# Cloud Run will run this command when a new instance starts
# We run the compiled JavaScript from the 'dist' folder
CMD [ "node", "dist/server.js" ]