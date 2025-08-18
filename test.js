// test.js
import { testConnection, runAutomation } from './automation.js';

async function runTests() {
  console.log('🚀 Starting connectivity tests...\n');
  
  // Test 1: Basic connectivity
  const connectionOk = await testConnection();
  
  if (connectionOk) {
    console.log('\n✅ Basic connectivity test passed!');
    console.log('🔄 Now testing full automation...\n');
    
    // Test 2: Full automation
    try {
      const result = await runAutomation('https://httpbin.org/links/5/0', (msg) => {
        console.log(msg);
      });
      
      console.log('\n✅ Automation test completed!');
      console.log(`📊 Captured ${result.captured.length} URLs`);
      
    } catch (error) {
      console.log('\n❌ Automation test failed:', error.message);
    }
  } else {
    console.log('\n❌ Basic connectivity failed. Check your internet connection.');
  }
}

runTests();
